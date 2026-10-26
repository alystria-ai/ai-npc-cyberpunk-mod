# Quest briefings: ask the quest giver about the job

Added 2026-10-26 from a player request (Nexus, YamiGenesis): "ask the quest giver for mission details with steps". When V asks the person who
gave a job what the job is, what to do or what comes next, that character explains it in-world: the objective, the steps ahead, the key places and
people, a tip or two, at the stage V has actually reached and never beyond it. 171 quests are written (every main job, side job and gig that a
roster character hands out; see Coverage below).

## What V gets

V is on a job from Regina (say Occupational Hazard) and asks her: "what do I do next?", "walk me through the job", "how do I get past the guards?"
or "und jetzt?". The turn's context then carries one short note (about 600 to 1,000 characters) for that turn only:

- the job in a sentence (what is asked, by whom, where);
- where V is in it right now (from the journal objectives that are active);
- what comes next, as the giver would lay it out from the plan, with no twist and no outcome;
- up to three places, three people and two tips that matter at this stage;
- the rule that this is all the character knows about the job: no later steps, twists, rewards or invented names.

The character says it in their own voice and language (the reply-language note still decides the language). Any other conversation, any other
speaker, a finished job, a stage the journal has not reached: no note.

## Where the facts come from

| Piece | Source |
| --- | --- |
| Which jobs V has, and which objectives are active | the journal inventory every turn already carries (`journalHistory`, `mod/journal-history.lua`): per quest `nativePath` (`quests/street_stories/...`, `ep1/quests/...`), `state`, and per objective `questRelativePath`, `state`, `optional`. Nothing new is read from the game. |
| Which objective means which stage | the briefing dataset, keyed by the same paths. An objective is `questRelativePath` without its first element, e.g. `sts_wat_nid_01/find`. |
| What to say | `research/cyberpunk/quest-briefings.json` (our own wording), built into `bridge/quest-briefing-data.mjs`. |

The key choice was checked against the user's own save (`runtime/knowledge-history.json`, 208 quests): all 18 pilot quests V has finished appear there with
the same `nativePath`, and 376 of their 378 objective paths are in the dataset (the two others are optional leftovers). After the full batch
(2026-10-26) the same save has 109 of the new quests, finished, and all 1,665 of their objective paths are in the dataset. (The save's
`observedAtMs` is written in bulk, so it cannot show play order.)
No change to the Lua collector was needed, and none is made. The objective paths of the dataset come from the cooked journal index (the private
research cache), so the builder checks every path against it.

## Dataset format

`research/cyberpunk/quest-briefings.json` (`version`, `policy`, `sources`, `quests`). One entry per quest, keyed by the journal quest path:

| Field | Meaning |
| --- | --- |
| `title` | the in-game quest name (people may search for it; the note does not use it, the character speaks of what the job is) |
| `givers` | roster profile keys who hand out the job and brief it |
| `knowers` | other roster characters who are part of it and may explain it (a companion who was there) |
| `overview` | one sentence, at most 220 characters: the job as V knows it when it first appears |
| `spoiler` | `none` (every stage text is what V already knows or the giver says) or `light` (a stage names a place or person V has not met, no twist) |
| `persistent` | optional: objectives that stay active the whole job (a parent "save the client" objective); they never decide the stage |
| `sources` | ids in `sources` of the pages read to learn the facts (see Copyright) |
| `stages[]` | in story order: `id`, `objectives` (the journal objectives whose being active puts V here), `now` (<= 200), `ahead` (<= 280), `places` (<= 3 x 60), `people` (<= 3 x 60), `tips` (<= 2 x 150) |

`research/cyberpunk/scripts/quest_briefing_schema.mjs` enforces the limits; `build_quest_briefings.mjs` also checks that the quest path and every
objective path exist in the cooked journal and lists non-optional objectives that no stage claims. The text must be plain: no markup, no UI words
("quest", "objective", "journal"), no dialogue lines.

### Spoiler policy

The stage selection can never reach a later stage (below). The text is the second guard: `now` and `ahead` only cover the stage V is in and the
step after it, written as the giver's plan. A twist, a betrayal, a death, a secret identity, a choice outcome or a reward is never written, even
when the source page has it. A stage that a first-time player could not yet know about is not in the note.

## Stage selection (`bridge/quest-briefing.mjs`)

1. The quest is one of V's active journal quests (lane `active`, state `active`, observed within the lane's age limit) that has a briefing and
   whose `givers` or `knowers` include the speaker. The quest is found by `nativePath`; an older collector that reports none is matched by the
   quest id (the last path segment) when it is unique.
2. With several candidates: the job V names (title words), then the tracked job, then a job the speaker gave over one they only know, then the
   one that changed last.
3. The stage is the one holding the tracked objective if that is active; otherwise the furthest stage with an active, non-optional objective.
   A stage whose objectives are not active is never chosen, so later stages cannot leak; `persistent` objectives are ignored.
4. If no active objective is in the dataset (a patch added one), the note carries the job sentence only and says not to invent steps.

## The screen (15 menu languages)

`briefingRequested(text)` is a cheap regular-expression screen (about 6 microseconds per message) over: job words (job, gig, mission, task,
contract, deal, briefing ...), request phrases (what next, walk me through, remind me, the details, where do I go ...), and question or
"say it again" words, plus any question mark. Languages: en de fr es it pt pl ru uk tr cs hu ja ko zh; Latin and Cyrillic stems start at a word
start, Japanese, Korean and Chinese match anywhere. It is generous on purpose: its real gate is the next step (the speaker must have the job
active), a miss would lose the feature, and a false positive only costs one lookup and, if this speaker does have such a job, one short note that
tells the character to ignore it when V is talking about something else.

Measured with 1,104 messages written by a Haiku helper in four rounds (the last two without any job word, and many without a question mark): a
keyword-only screen caught only 37 percent of a fresh set, which is why the question and "say it again" words and the question mark were added; the screen
then caught 96 percent of one fresh set and 86 percent of the next before tuning, and all of them after (the fixture `bridge/quest-briefing-phrases.json` keeps
them as a regression test: at least 99.5 percent caught, at least 88 percent of 308 plain statements stay quiet). A plain statement ("Nice jacket.") passes
about 9 percent of the time.

## Wiring and cost

- `withConversationKnowledge` (bridge/quest-context.mjs) computes the note once per turn, only when the screen passes, from the already-bound
  journal inventory; it is kept with the other trusted knowledge of the turn and bound to the turn's identity. No inventory, no note.
- `conversationContextBlocks` emits it as a `volatile` block right after the journal block, only when the Dynamic info "Quest and journal" switch
  is on (it is off together with the journal, jobs and history, and the inventory is not even sent then). Convai receives the blocks joined as its
  dynamic info; Mistral, Local AI and Custom read the same block through the `volatile` tier of their prompt layout, so no stable block moves and a
  prefix cache keeps working. Phone chat, F6, F7 and group rounds all go through this one builder.
- Ordinary NPCs (pedestrians, vendors) and automatic reactions never get it.
- Cost: one regular expression per turn; the selection walks the active quests (0.07 ms over 208 quests); the note is about 250 tokens and exists only
  on turns that ask about a job this speaker has. No per-frame work, no new Lua, no new setting, no UI string.

## Coverage (171 quests, 1,049 stages)

Scope: the cooked journal's MainQuest (92, Phantom Liberty included), SideQuest (47), StreetStory (90) and Contract (48) entries, 277 in all.
VehicleQuest, CyberPsycho, MinorQuest and Courier are out of scope.

| Kind | Written | of which pilot |
| --- | --- | --- |
| Main jobs (base game, incl. Tapeworm) | 37 | 10 |
| Main jobs (Phantom Liberty, incl. Run This Town) | 19 | 1 |
| Side jobs (incl. New Person, Same Old Mistakes) | 34 | 1 |
| Gigs (base game) | 72 | 8 |
| Gigs (Phantom Liberty) | 9 | 0 |

Givers: Regina 23, Reed 13, Mr. Hands 13, El Capitán 11, Padre 11, Panam, Wakako, Dakota and Judy 9 each, Rogue 8 (she also hands out four gigs:
The Union Strikes Back, Nasty Hangover, Hot Merchandise, Family Heirloom), Johnny 7, Dino, Takemura and Claire 5 each, and 23 others.

Skipped (106), by reason:

| Reason | Count |
| --- | --- |
| NCPD hustles (the 45 `minor_activities` Contract entries, plus one `!DUPLICATE` copy): the police scanner, no giver | 46 |
| Save-version trackers (`game_version_tracking`), engine templates, the undiscovered-gig placeholder, an `e3_vm_hack_v2` test entry | 20 |
| Delamain jobs (Human Nature, Tune Up, Epistrophy and its seven districts, Don't Lose Your Mind): Delamain is not in the roster | 11 |
| Reward pickups (the six district rewards, Hi Ho Silver Lining, The Gig): no job, and rewards are never written | 8 |
| Umbrella trackers whose objectives summarise other jobs (Phantom Liberty, Become A Legend, Hidden in the Shadows, Kunitsu-kami, Survive, Out of the City) and three meta entries with no objectives | 9 |
| Ending epilogues (Where is My Mind?, All Along the Watchtower, Path of Glory, New Dawn Fades, Things Done Changed) and Changes (the ending choice itself): cutscene-led, and any wording names the ending | 6 |
| Cut or untraceable content: Hothead, Am I Demon? (no guide anywhere), the untitled head-hunter side job, the untitled sandbox race | 4 |
| No one to ask: This Corrosion (an unknown sender and a netrunner outside the roster), From Her to Eternity (a recorded message) | 2 |

How the 151 new entries were made (2026-10-26): five written by hand as worked examples (Big Pete's Got Big Problems, Dogtown Saints, Olive Branch,
I Walk the Line, Dream On), then `research/cyberpunk/QUEST_BRIEFING_RECIPE.md` and eleven Haiku helpers of 6 to 25 quests each wrote the other 146.
Every part file passed `--fragment` with no warnings (every non-optional objective is in a stage). The lead then read every overview and every `ahead`
for spoilers and checked 24 quests by hand for stage order, grouping and giver (23 against a walkthrough, Last Caress against the journal): The Streetkid, The Rescue, Search and Destroy,
Last Caress, We Gotta Live Together, Knockin' on Heaven's Door, Spider and the Fly, The Damned, Run This Town, Birds with Broken Wings, Black Steel
In The Hour of Chaos, The Killing Moon, A Like Supreme, I Fought the Law, Sinnerman, Ex-Factor, A Cool Metal Fire, Concrete Cage Trap, Woman of La
Mancha, The Union Strikes Back, Dancing on a Minefield, Hot Merchandise, Family Heirloom, Prototype in the Scraper. Fixed in review: 13 `ahead` lines that announced a surprise (Oda's attack, the assault at
Takemura's hideout, the police after the van, a prisoner in the Scraper, the Sampson finish, an ambush after the minefield), 13 phrases too close
to the game's objective text, A Cool Metal Fire rewritten (it is Johnny's night out in V's body during Chippin' In), givers and knowers on 14
jobs (Lucretia My Reflection is Myers' job before it is Reed's; the Peralezes give I Fought the Law, River knows it; Black Steel's netrunners are Nix,
Carol Emeka and Chang-Hoon Nam; clients such as Briana, Nele, Ana and Steven, Bill and Chang-Hoon Nam added as knowers), New Dawn Fades moved to the
skipped epilogues. Written from one source only: (Don't Fear) The Reaper and A Cool Metal Fire.

### Pilot (20 quests, 124 stages)

| Quest | Path | Givers | Stages | Spoiler |
| --- | --- | --- | --- | --- |
| The Ride | `quests/main_quest/prologue/q001_02_dex` | dexter-deshawn | 3 | none |
| The Pickup | `quests/main_quest/prologue/q003_maelstrom` | dexter-deshawn | 7 | none |
| The Information | `quests/main_quest/prologue/q004_braindance` | dexter-deshawn, evelyn-parker | 7 | none |
| The Heist | `quests/main_quest/prologue/q005_heist` | dexter-deshawn | 8 | none |
| The Ripperdoc | `quests/main_quest/prologue/q001_01_victor` | jackie-welles | 5 | none |
| Ghost Town | `quests/main_quest/act_01/q103_warhead` | panam-palmer (Rogue knows) | 10 | light |
| Lightning Breaks | `quests/main_quest/act_01/q104_01_sabotage` | panam-palmer | 4 | none |
| Life During Wartime | `quests/main_quest/act_01/q104_02_av_chase` | panam-palmer | 8 | light |
| Down on the Street | `quests/main_quest/act_01/q112_01_old_friend` | takemura | 5 | light |
| Playing for Time | `quests/main_quest/act_01/q101_resurrection` | takemura | 6 | light |
| Gig: Occupational Hazard | `quests/street_stories/watson/northside_industrial_district/sts_wat_nid_01` | regina-jones | 5 | none |
| Gig: Dirty Biz | `.../northside_industrial_district/sts_wat_nid_04` | regina-jones | 4 | none |
| Gig: Many Ways to Skin a Cat | `.../northside_industrial_district/sts_wat_nid_02` | regina-jones | 5 | none |
| Gig: A Lack of Empathy | `quests/street_stories/city_center/downtown/sts_cct_dtn_03` | dino-dinovic | 5 | none |
| Gig: Serious Side Effects | `quests/street_stories/santo_domingo/arroyo/sts_std_arr_01` | muamar-reyes | 7 | light |
| Gig: Getting Warmer... | `quests/street_stories/heywood/vista_del_rey/sts_hey_rey_09` | wakako-okada | 5 | none |
| Gig: Bring Me the Head of Gustavo Orta | `.../vista_del_rey/sts_hey_rey_01` | padre-ibarra | 5 | none |
| Gig: On a Tight Leash | `quests/street_stories/heywood/wellsprings/sts_hey_spr_01` | padre-ibarra | 6 | none |
| Get It Together (Phantom Liberty) | `ep1/quests/main_quest/q303_hands` | solomon-reed, mr-hands | 9 | light |
| Chippin' In | `quests/side_quest/sq031_rogue` | rogue-amendiares | 10 | light |

The pilot entries were kept unchanged when the full batch was merged.

## Copyright and sources

Nothing is copied from a website or from the game. Helpers read public walkthroughs to learn the facts, then wrote short sentences of their own;
the dataset has no quotes and no dialogue. Each quest lists the pages it was learned from (`sources` in the research file: 328 pages, mostly PowerPyx,
Game Guides, Fextralife and Sportskeeda; the Cyberpunk wiki on fandom.com answered HTTP 402 to every fetch on 2026-10-26, so no wiki page is cited). The English objective
text the game itself shows stays in the private cache and the outline script's output; it is never written into the dataset.

## How to extend (a batch of quests)

1. Pick quests. `python -I -X utf8 research/cyberpunk/scripts/quest_outline.py --list --type StreetStory` lists the cooked journal quests with their
   types (it reads the private research cache, found in the main checkout from a worktree). `--path <quest path>` prints one quest's objectives in
   journal order with the game's English text (an aid for understanding, not for copying).
2. For each quest: read two or more walkthroughs, then write the entry in your own words: the giver (roster key; `characters/roster.json`), the
   overview, the stages in story order with the objectives of each, and the short `now`, `ahead`, places, people, tips. Put parent objectives that
   stay active all job in `persistent`. Fandom pages may be unreachable; PowerPyx, Game Guides and Fextralife worked.
   For many quests, give a Haiku helper `research/cyberpunk/QUEST_BRIEFING_RECIPE.md` (procedure, field checklist, stage-grouping and spoiler
   rules, worked examples) and a batch of 6 to 25 quests; eleven helpers wrote 146 entries in 10 to 16 minutes each on 2026-10-26. Their
   structure was sound (every objective placed, branch stages kept apart); what needed the lead's pass was `ahead` lines that announce a
   surprise, phrases close to the game's objective text, and givers or knowers (a client on V's side is a knower, a target never).
3. Add the entry and its sources to `research/cyberpunk/quest-briefings.json`; validate a part file first with
   `node research/cyberpunk/scripts/build_quest_briefings.mjs --fragment <part.json>`.
4. `node research/cyberpunk/scripts/build_quest_briefings.mjs` rewrites `bridge/quest-briefing-data.mjs` (one line per quest); `--check` fails when it is stale.
5. `node --test bridge/quest-briefing.test.mjs` (it also checks the built file against the research file and renders every stage).
6. Size: at 171 quests and 1,049 stages the module is 524 KB and its import adds about 10 ms to bridge start-up (measured 2026-10-26; the bridge is
   its own process, so no frame cost), so it stays a static import. If it ever passes about 1 MB, load it on the first matching turn instead (the
   call site is synchronous, so read and parse a JSON file once instead of the static import).

Stage grouping is the part to check by hand: the journal lists branch and alternative objectives in file order, not play order.

## Limits and live checks

- Only the live game can show the stage choice on a real playthrough and the quality of what the model says from the note. Suggested check: take Occupational
  Hazard (or any pilot job) from Regina, ask "what do I do next?" at each step, compare the answer with the journal and the stage text, and ask something off
  topic to see that she does not drag the job in. The model may still shorten or reword; filtering input cannot guarantee a spoiler-free sentence
  (see QUEST_CONTEXT.md).
- Stage order and grouping were written from walkthroughs and the journal's file order and not played through for each quest; objectives in a stage that
  fire at another moment (two Ghost Town and Chippin' In objectives were flagged as guesses) would make the note a step early or late, never beyond the
  active objectives. The helpers of the full batch flagged such guesses too, mostly in long jobs whose guides do not map every objective (The
  Rescue, Never Fade Away, Forward to Death, Somewhat Damaged, Spider and the Fly, Riders on the Storm, The Hunt); placements there were inferred
  from the objective names.
- The objective paths are from game 2.31's cooked journal. A live save on 2.5 matched them (the pilot quests V has finished), but a patch can rename an
  objective; the fallback is the job sentence alone.
- Only quests with a briefing and a giver or knower in the roster are covered. Givers who are not in the roster (many minor NPCs) are not briefed.
